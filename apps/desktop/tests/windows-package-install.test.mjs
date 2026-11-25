import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {windowsInstall} from '../tools/install-windows.mjs';
import {validateWindowsCandidate,packageWindowsCandidate} from '../tools/package-windows-candidate.mjs';
import {openPayload,sha256,json} from '../tools/windows-install-core.mjs';
import {openExperimentalPersistenceParent} from '../src/platform/windows/experimental-persistence.mjs';
import {detectWindowsInstallation} from '../src/main/auto-update-windows.mjs';
import {windowsQualificationPassed,windowsReleaseCases} from '../tools/windows-qualification-verdict.mjs';

const native={skip:process.platform!=='win32'||process.arch!=='x64'};
const app='resources/app/';
function syntheticPE(){const bytes=Buffer.alloc(256);bytes.write('MZ');bytes.writeUInt32LE(128,60);bytes.writeUInt32LE(0x4550,128);bytes.writeUInt16LE(0x8664,132);return bytes;}
async function fixture(t){const directory=await fs.mkdtemp(path.join(os.tmpdir(),'nozeli-package-behavior-'));t.after(()=>fs.rm(directory,{recursive:true,force:true}));return {directory,root:path.join(directory,'安装 空间'),candidate:name=>path.join(directory,name)};}
async function candidate(directory,version='synthetic-1',protocol=false){
 await fs.mkdir(directory);
 const payload={
  'Nozeli.exe':syntheticPE(),[app+'runtime/node/node.exe']:syntheticPE(),[app+'runtime/node/NODE-RUNTIME.json']:json({platform:'win32',arch:'x64',executable:'node.exe',sha256Executable:sha256(syntheticPE())}),
  [app+'package.json']:json({version}),[app+'dist/renderer/app.js']:'synthetic renderer',
  [app+'integrations/pi/build.mjs']:'synthetic build input',[app+'integrations/pi/tools/patch-sdk.mjs']:'synthetic patch input',
  [app+'node_modules/dugite/git/cmd/git.exe']:syntheticPE(),
  [app+'native/windows/build/Release/synthetic.node']:syntheticPE(),[app+'native/windows/input.cc']:'synthetic native source',
  [app+'用户 空格.txt']:'synthetic Unicode content '+version,
 };
 for(const name of ['install-windows.mjs','windows-install-core.mjs','package-windows-candidate.mjs','local-release.mjs','release-retention.mjs','package-pi-runtime.mjs','package-node-runtime.mjs'])payload[app+'tools/'+name]='synthetic installation tool';
 // A native-protocol candidate carries the updater backend/helper/package
 // modules plus the exact RELEASE.json/commit/provenance binding the
 // validator demands before activation is admitted.
 const commit='a'.repeat(40);
 if(protocol){for(const name of ['auto-update-windows.mjs','auto-update-windows-helper.mjs','auto-update-windows-package.mjs'])payload[app+'src/main/'+name]='synthetic Windows update protocol component';payload['RELEASE.json']=json({application:'Nozeli',platform:'win32',arch:'x64',version,commit,autoUpdate:'native-windows-health-v1'});}
 const sdkOutputs=['dist/core/model-config.js','dist/core/model-runtime.js','dist/core/models-store.js','dist/core/model-config.d.ts','dist/core/model-runtime.d.ts','dist/core/models-store.d.ts','dist/utils/paths.js'];
 const files=sdkOutputs.map((name,i)=>{const bytes='synthetic SDK output '+i;payload[app+'integrations/pi/node_modules/@earendil-works/pi-coding-agent/'+name]=bytes;return {path:name,sha256:sha256(bytes)};});
 payload[app+'integrations/pi/patches/sdk/model-storage-1.4.0.json']=json({schema:1,files});
 for(const [name,bytes] of Object.entries(payload)){await fs.mkdir(path.dirname(path.join(directory,name)),{recursive:true});await fs.writeFile(path.join(directory,name),bytes);}
 const tree=await openPayload(directory);try{await fs.writeFile(path.join(directory,'WINDOWS-CANDIDATE.json'),json({schema:1,application:'Nozeli',kind:'windows-manual-candidate',platform:'win32',arch:'x64',version,...(protocol?{commit,automaticUpdater:'native-windows-health-v1'}:{automaticUpdater:'unsupported'}),nativeProvenance:{schema:1,files:{[app+'native/windows/build/Release/synthetic.node']:sha256(syntheticPE())},buildInputs:{[app+'native/windows/input.cc']:sha256('synthetic native source')},...(protocol?{commit}:{})},entries:tree.entries}));}finally{tree.close();}
 return directory;
}
const state=root=>fs.readFile(path.join(root,'ACTIVE.json'),'utf8').then(JSON.parse);

test('candidate rejects a manifest version that differs from the packaged application',native,async t=>{
 const f=await fixture(t),input=await candidate(f.candidate('mismatch')),file=path.join(input,'WINDOWS-CANDIDATE.json');
 const manifest=JSON.parse(await fs.readFile(file));
 // The payload inventory is unchanged and this version would select a different search requirement.
 manifest.version='0.1.0-beta.8';await fs.writeFile(file,json(manifest));
 await assert.rejects(validateWindowsCandidate(input),{code:'CANDIDATE_PROVENANCE',message:'Packaged application version differs from the candidate'});
});

test('release qualification refuses skipped or omitted required cases',()=>{
 const names=windowsReleaseCases,counts={tests:names.length,pass:names.length,fail:0,skipped:0,cancelled:0};
 const check=(cases,summary=counts)=>windowsQualificationPassed({suite:'release',exitCode:0,identityVerified:true,counts:summary,tap:cases.map((name,i)=>`ok ${i+1} - ${name}`).join('\n')});
 assert.equal(check(names),true);
 assert.equal(check([names[0]+' # SKIP unavailable',...names.slice(1)],{...counts,pass:counts.pass-1,skipped:1}),false);
 assert.equal(check(['an unrelated test',...names.slice(1)]),false);
});

test('real filesystem install, upgrade and rollback preserve separate synthetic profile and immutable versions',native,async t=>{
 const f=await fixture(t),one=await candidate(f.candidate('one')),two=await candidate(f.candidate('two'),'synthetic-2');
 const installed=await windowsInstall({root:f.root,command:'install',candidate:one});
 const profileFile=path.join(installed.profile,'user-draft.txt');await fs.writeFile(profileFile,'unsaved synthetic draft');
 const initial=await fs.readFile(path.join(f.root,'versions',installed.active,app+'用户 空格.txt'));
 const upgraded=await windowsInstall({root:f.root,command:'upgrade',candidate:two});assert.equal(upgraded.previous,installed.active);assert.notEqual(upgraded.active,installed.active);
 assert.deepEqual(await fs.readFile(path.join(f.root,'versions',installed.active,app+'用户 空格.txt')),initial);
 await windowsInstall({root:f.root,command:'rollback'});assert.equal((await state(f.root)).active,installed.active);assert.equal((await state(f.root)).previous,upgraded.active);
 assert.equal(await fs.readFile(profileFile,'utf8'),'unsaved synthetic draft');
 const status=await windowsInstall({root:f.root,command:'status'});assert.equal(status.automaticUpdater,'unsupported');assert.equal(status.versions.length,2);assert.equal(status.installerLock,false);assert.ok(status.versions.every(v=>v.state==='verified'));
});

test('legacy unsupported manual installation migrates into the native Windows updater protocol by explicit upgrade',native,async t=>{
 // A legacy pre-protocol installation is byte-identical to what the current
 // tool still writes for an 'unsupported' candidate (the a04a4dd VM baseline
 // and the alpha6 lineage both froze the same launcher bytes), so ownership
 // acceptance rests on the frozen launcher digest, never on the owner
 // record's updater field.
 const f=await fixture(t),legacy=await candidate(f.candidate('legacy')),protocol=await candidate(f.candidate('protocol'),'0.2.0',true);
 const installed=await windowsInstall({root:f.root,command:'install',candidate:legacy});
 assert.equal(installed.automaticUpdater,'unsupported');assert.equal(installed.updater,false);
 const ownerPath=path.join(f.root,'WINDOWS-INSTALL.json'),launcherPath=path.join(f.root,'Launch-Nozeli.ps1');
 const ownerBytes=await fs.readFile(ownerPath),launcherBytes=await fs.readFile(launcherPath);
 const frozenLegacyDigest='20e2aad2ceb7a9aa9fbff3ea3e5870c8f09ba2d4d4486ee061be27f695c68f8d';
 const owner=JSON.parse(ownerBytes);
 assert.equal(owner.automaticUpdater,'unsupported');assert.equal(owner.launcherSha256,frozenLegacyDigest);
 assert.equal(sha256(launcherBytes),frozenLegacyDigest);
 const draft=path.join(installed.profile,'legacy-draft.txt');await fs.writeFile(draft,'legacy unsaved draft');
 const legacyMarker=await fs.readFile(path.join(f.root,'versions',installed.active,app+'用户 空格.txt'));
 const before=await windowsInstall({root:f.root,command:'status'});assert.equal(before.updater,false);assert.equal(before.automaticUpdater,'unsupported');
 const migrated=await windowsInstall({root:f.root,command:'upgrade',candidate:protocol});
 assert.equal(migrated.previous,installed.active);assert.notEqual(migrated.active,installed.active);
 assert.equal(migrated.automaticUpdater,'native-windows-health-v1');assert.equal(migrated.updater,true);
 const status=await windowsInstall({root:f.root,command:'status'});
 assert.equal(status.updater,true);assert.equal(status.automaticUpdater,'native-windows-health-v1');assert.equal(status.installerLock,false);
 const rows=Object.fromEntries(status.versions.map(row=>[row.id,row]));
 assert.equal(rows[installed.active].state,'verified');assert.equal(rows[installed.active].automaticUpdater,'unsupported');
 assert.equal(rows[migrated.active].state,'verified');assert.equal(rows[migrated.active].automaticUpdater,'native-windows-health-v1');
 const active=await state(f.root);assert.equal(active.active,migrated.active);assert.equal(active.previous,installed.active);assert.equal(active.generation,2);
 const detected=await detectWindowsInstallation(path.join(f.root,'versions',migrated.active,app));
 assert.equal(detected.updater,true);assert.equal(detected.profile,installed.profile);
 assert.equal(detected.identity.activeId,migrated.active);assert.equal(detected.identity.generation,2);
 assert.deepEqual(await fs.readFile(path.join(f.root,'versions',installed.active,app+'用户 空格.txt')),legacyMarker);
 assert.equal(await fs.readFile(draft,'utf8'),'legacy unsaved draft');
 assert.deepEqual(await fs.readFile(ownerPath),ownerBytes);
 assert.deepEqual(await fs.readFile(launcherPath),launcherBytes);
});

test('first install refuses preexisting unrelated target without modifying it',native,async t=>{
 const f=await fixture(t),input=await candidate(f.candidate('candidate'));await fs.mkdir(f.root);await fs.writeFile(path.join(f.root,'unrelated'),'keep');
 await assert.rejects(windowsInstall({root:f.root,command:'install',candidate:input}),{code:'INSTALL_NOT_EMPTY'});assert.deepEqual(await fs.readdir(f.root),['unrelated']);assert.equal(await fs.readFile(path.join(f.root,'unrelated'),'utf8'),'keep');
});

test('candidate copy is complete and tampering, extra files, wrong architecture and provenance are rejected',native,async t=>{
 const f=await fixture(t),input=await candidate(f.candidate('candidate')),copy=f.candidate('copy');
 const original=await validateWindowsCandidate(input);original.tree.close();await packageWindowsCandidate({input,candidate:copy});
 assert.deepEqual(await fs.readFile(path.join(input,'WINDOWS-CANDIDATE.json')),await fs.readFile(path.join(copy,'WINDOWS-CANDIDATE.json')));
 await fs.writeFile(path.join(copy,app+'用户 空格.txt'),'tampered');await assert.rejects(validateWindowsCandidate(copy),{code:'CANDIDATE_TAMPERED'});
 await fs.writeFile(path.join(input,'unlisted.txt'),'extra');await assert.rejects(validateWindowsCandidate(input),{code:'CANDIDATE_TAMPERED'});
 const manifestFile=path.join(input,'WINDOWS-CANDIDATE.json'),manifest=JSON.parse(await fs.readFile(manifestFile));manifest.arch='arm64';await fs.writeFile(manifestFile,json(manifest));await assert.rejects(validateWindowsCandidate(input),{code:'CANDIDATE_REJECTED'});
});

test('an independently held installer lock wins without copying or publishing',native,async t=>{
 const f=await fixture(t),input=await candidate(f.candidate('candidate'));await windowsInstall({root:f.root,command:'install',candidate:input});
 const before=await fs.readFile(path.join(f.root,'ACTIVE.json')),versions=await fs.readdir(path.join(f.root,'versions'));
 const parent=openExperimentalPersistenceParent(f.root,'.install-lock'),held=parent.createPrivateTreeRootExclusive('.install-lock');
 try{await assert.rejects(windowsInstall({root:f.root,command:'upgrade',candidate:input}));assert.deepEqual(await fs.readFile(path.join(f.root,'ACTIVE.json')),before);assert.deepEqual(await fs.readdir(path.join(f.root,'versions')),versions);}
 finally{held.removePrivateEmptyDirectory();held.close();parent.close();}
});

test('native locked active-state winner preserves the original pointer and reconciliation lock',native,async t=>{
 const f=await fixture(t),input=await candidate(f.candidate('candidate'));await windowsInstall({root:f.root,command:'install',candidate:input});
 const before=await fs.readFile(path.join(f.root,'ACTIVE.json'));
 const parent=openExperimentalPersistenceParent(f.root,'ACTIVE.json'),winner=parent.beginReplacement('ACTIVE.json');
 try{await assert.rejects(windowsInstall({root:f.root,command:'upgrade',candidate:input}),e=>e.reconciliationRequired===true);assert.deepEqual(await fs.readFile(path.join(f.root,'ACTIVE.json')),before);}
 finally{winner.close();parent.close();}
 const status=await windowsInstall({root:f.root,command:'status'});assert.equal(status.installerLock,true);assert.equal(status.state.active,JSON.parse(before).active);
});

test('tampered rollback leaves active pointer and user profile unchanged',native,async t=>{
 const f=await fixture(t),one=await candidate(f.candidate('one')),two=await candidate(f.candidate('two'),'synthetic-2');
 const installed=await windowsInstall({root:f.root,command:'install',candidate:one});await windowsInstall({root:f.root,command:'upgrade',candidate:two});
 const draft=path.join(installed.profile,'draft.txt');await fs.writeFile(draft,'keep synthetic profile');const before=await fs.readFile(path.join(f.root,'ACTIVE.json'));
 await fs.writeFile(path.join(f.root,'versions',installed.active,app+'用户 空格.txt'),'tamper rollback');
 await assert.rejects(windowsInstall({root:f.root,command:'rollback'}),{code:'CANDIDATE_TAMPERED'});
 assert.deepEqual(await fs.readFile(path.join(f.root,'ACTIVE.json')),before);assert.equal(await fs.readFile(draft,'utf8'),'keep synthetic profile');
 const status=await windowsInstall({root:f.root,command:'list'});assert.equal(status.installerLock,true);assert.ok(status.versions.some(v=>v.state==='unknown-retained'));
});

test('hardlinks and reparse candidate entries are rejected without repair',native,async t=>{
 const f=await fixture(t),input=await candidate(f.candidate('candidate'));await fs.link(path.join(input,app+'用户 空格.txt'),path.join(input,'alias'));
 await assert.rejects(validateWindowsCandidate(input));await fs.unlink(path.join(input,'alias'));
 const outside=f.candidate('outside');await fs.mkdir(outside);await fs.writeFile(path.join(outside,'unrelated'),'keep');await fs.symlink(outside,path.join(input,'junction'),'junction');
 await assert.rejects(validateWindowsCandidate(input));assert.equal(await fs.readFile(path.join(outside,'unrelated'),'utf8'),'keep');
});

test('tampered upgrade preserves active payload/profile and retains the failed operation lock',native,async t=>{
 const f=await fixture(t),one=await candidate(f.candidate('one')),two=await candidate(f.candidate('two'),'synthetic-2');
 const installed=await windowsInstall({root:f.root,command:'install',candidate:one});const draft=path.join(installed.profile,'draft');await fs.writeFile(draft,'synthetic preserved draft');const before=await fs.readFile(path.join(f.root,'ACTIVE.json'));
 await fs.writeFile(path.join(two,app+'dist/renderer/app.js'),'tampered renderer');await assert.rejects(windowsInstall({root:f.root,command:'upgrade',candidate:two}),{code:'CANDIDATE_TAMPERED'});
 assert.deepEqual(await fs.readFile(path.join(f.root,'ACTIVE.json')),before);assert.equal(await fs.readFile(draft,'utf8'),'synthetic preserved draft');const status=await windowsInstall({root:f.root,command:'status'});assert.equal(status.installerLock,true);assert.equal(status.versions.length,1);
});

test('declared native provenance must match actual native bytes independently of full inventory',native,async t=>{
 const f=await fixture(t),input=await candidate(f.candidate('candidate')),file=path.join(input,'WINDOWS-CANDIDATE.json'),manifest=JSON.parse(await fs.readFile(file));
 manifest.nativeProvenance.files[app+'native/windows/build/Release/synthetic.node']='0'.repeat(64);await fs.writeFile(file,json(manifest));
 await assert.rejects(validateWindowsCandidate(input),{code:'CANDIDATE_PROVENANCE'});
});

test('self-consistent replacement manifest cannot replace an installed digest registry entry',native,async t=>{
 const f=await fixture(t),input=await candidate(f.candidate('candidate'));const installed=await windowsInstall({root:f.root,command:'install',candidate:input}),payload=path.join(f.root,'versions',installed.active),file=path.join(payload,'WINDOWS-CANDIDATE.json');
 const manifest=JSON.parse(await fs.readFile(file)),entry=manifest.entries.find(e=>e.path===app+'dist/renderer/app.js'),replacement='self-consistent but unapproved renderer';await fs.writeFile(path.join(payload,entry.path),replacement);entry.bytes=Buffer.byteLength(replacement);entry.sha256=sha256(replacement);await fs.writeFile(file,json(manifest));
 const validAsNewCandidate=await validateWindowsCandidate(payload);validAsNewCandidate.tree.close();const status=await windowsInstall({root:f.root,command:'status'});assert.equal(status.versions[0].state,'unknown-retained');assert.equal(status.versions[0].code,'CANDIDATE_TAMPERED');
 await assert.rejects(windowsInstall({root:f.root,command:'launch'}),{code:'CANDIDATE_TAMPERED'});assert.equal((await state(f.root)).active,installed.active);
});

test('failed native executable admission preserves profile and permits explicit previous-version rollback',native,async t=>{
 const f=await fixture(t),one=await candidate(f.candidate('one')),two=await candidate(f.candidate('two'),'synthetic-2');
 const installed=await windowsInstall({root:f.root,command:'install',candidate:one});await windowsInstall({root:f.root,command:'upgrade',candidate:two});
 const draft=path.join(installed.profile,'unsent-draft.txt');await fs.writeFile(draft,'Independent unsent draft 中文');const before=await fs.readFile(path.join(f.root,'ACTIVE.json'));
 // The valid PE header fixture is deliberately not an executable image. The
 // actual Windows CreateProcess failure must not strand the installer lock.
 await assert.rejects(windowsInstall({root:f.root,command:'launch'}),error=>error.code==='INSTALL_LAUNCH_NOT_STARTED'&&error.launchEffect==='not-started'&&error.reconciliationRequired===false);
 assert.deepEqual(await fs.readFile(path.join(f.root,'ACTIVE.json')),before);assert.equal(await fs.readFile(draft,'utf8'),'Independent unsent draft 中文');
 await assert.rejects(fs.stat(path.join(f.root,'.install-lock')),{code:'ENOENT'});
 await windowsInstall({root:f.root,command:'rollback'});assert.equal((await state(f.root)).active,installed.active);assert.equal(await fs.readFile(draft,'utf8'),'Independent unsent draft 中文');
});
