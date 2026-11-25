import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {createRequire} from 'node:module';
import {spawnSync} from 'node:child_process';
const require=createRequire(import.meta.url);
const [requestedOutput,electron=require('electron'),node=process.execPath]=process.argv.slice(2);
const appRoot=path.resolve(import.meta.dirname,'..'),inputPaths=['src/main/tree-recovery.mjs','src/main/cross-tree-recovery.mjs','src/main/project-storage.mjs','src/main/storage-recovery.mjs','src/platform/windows/tree-recovery.mjs','src/platform/windows/cross-tree-recovery.mjs','tests/windows-desktop-cross-recovery.test.mjs','tests/fixtures/windows-cross-recovery-child.mjs','src/main/workspace-native.mjs','src/main/cross-tree-surfaces.mjs','src/main/workspace-recovery-state.mjs','src/platform/windows/tree-surface-observation.mjs','src/main/main.cjs','src/main/online-browser.mjs','src/main/workspace-capture.mjs','src/main/update-lifecycle.mjs','tests/windows-desktop-live-recovery.test.mjs','tests/online-browser.test.mjs','tests/windows-desktop-cold-source.test.mjs','tests/fixtures/windows-cold-source-child.mjs','tests/update-lifecycle.test.mjs','src/main/cross-tree-surface-journal.mjs','src/main/file-tree-ops.mjs','tests/fixtures/windows-live-surface-host.mjs','tests/fixtures/windows-live-recovery-main.cjs','src/renderer/app.mjs'];
const hash=file=>createHash('sha256').update(fs.readFileSync(path.join(appRoot,file))).digest('hex'),inputs=inputPaths.map(path=>({path,sha256:hash(path)}));
const output=requestedOutput??process.env.NOZELI_TEST_EVIDENCE_ROOT??path.join(import.meta.dirname,'../.test-output/ci/windows-desktop-cold-source-'+Date.now());
assert(path.isAbsolute(output));assert.equal(process.platform,'win32');fs.mkdirSync(path.dirname(output),{recursive:true});fs.mkdirSync(output);const runs=[];let result;
try{
 for(const [host,command]of [['node',node],['electron',electron]]){
  const env={...process.env};for(const key of Object.keys(env))if(/^(NOZELI_|CCB_|CODEX_|OMP_|PI_|GIT_)/i.test(key)||/AUTH|TOKEN|SECRET|PASSWORD|CREDENTIAL|API_?KEY|ASKPASS/i.test(key)||/^path$/i.test(key)||['NODE_OPTIONS','NODE_PATH','ELECTRON_RUN_AS_NODE'].includes(key))delete env[key];env.Path=path.join(env.SystemRoot??env.SYSTEMROOT,'System32');if(host==='electron')env.ELECTRON_RUN_AS_NODE='1';
  const child=spawnSync(command,['--test','--test-concurrency=1','--test-reporter=tap',...['windows-desktop-live-recovery.test.mjs','windows-desktop-cold-source.test.mjs','online-browser.test.mjs','update-lifecycle.test.mjs'].map(file=>path.join(import.meta.dirname,file))],{cwd:path.resolve(import.meta.dirname,'..'),env,encoding:'utf8',windowsHide:true,timeout:600000,maxBuffer:4*1024*1024});fs.writeFileSync(path.join(output,host+'.tap'),child.stdout??'');fs.writeFileSync(path.join(output,host+'.err'),child.stderr??'');
 const run={host,command,systemOnlyPath:env.Path,status:child.status,signal:child.signal,pass:Number(child.stdout?.match(/^# pass (\d+)$/m)?.[1]),fail:Number(child.stdout?.match(/^# fail (\d+)$/m)?.[1]),skip:Number(child.stdout?.match(/^# skipped (\d+)$/m)?.[1])};runs.push(run);for(const input of inputs)assert.equal(hash(input.path),input.sha256,'Source changed while '+host+' ran: '+input.path);assert.ifError(child.error);assert.equal(child.status,0,child.stdout+'\n'+child.stderr);assert.equal(child.signal,null);assert.equal(run.pass,47);assert.equal(run.fail,0);assert.equal(run.skip,0);
 }
 result={ok:true,scope:'Windows same-host and whole-process cold original source protection, immutable recovery objects, exact native identity restoration and paired receipt recovery; includes browser/update regressions; generic workspace fixture remains unqualified on Windows',inputs,runs};
}catch(error){result={ok:false,error:error.stack,runs};process.exitCode=1;}
fs.writeFileSync(path.join(output,'report.json'),JSON.stringify(result,null,2));console.log(JSON.stringify(result,null,2));
