import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {createRequire} from 'node:module';
import {spawnSync} from 'node:child_process';
const require=createRequire(import.meta.url);
const [requestedOutput,electron=require('electron'),node=process.execPath]=process.argv.slice(2);
const appRoot=path.resolve(import.meta.dirname,'..'),inputPaths=["src/main/file-tree-ops.mjs", "src/main/tree-recovery.mjs", "src/main/same-tree-recovery.mjs", "src/main/storage-recovery.mjs", "src/main/project-storage.mjs", "src/main/storage-worker.mjs", "src/platform/windows/same-tree-recovery.mjs", "src/platform/windows/tree-recovery.mjs", "src/platform/windows/cross-tree-recovery.mjs", "src/platform/windows/desktop-file-tree.mjs", "src/platform/windows/desktop-directory-transfer.mjs", "src/main/workspace-native.mjs", "src/renderer/app.mjs", "src/main/cross-tree-recovery.mjs", "tests/windows-desktop-same-tree-recovery.test.mjs", "tests/fixtures/windows-same-tree-child.mjs", "tests/fixtures/windows-same-tree-seed.mjs", "tests/windows-desktop-same-tree-recovery.mjs", "tests/windows-desktop-file-transfer.test.mjs", "tests/windows-desktop-directory-transfer.test.mjs", "tests/windows-desktop-tree-recovery.test.mjs", "tests/windows-desktop-cross-recovery.test.mjs", "tests/storage-recovery-batch.test.mjs", "src/main/storage-database.mjs"];
const hash=file=>createHash('sha256').update(fs.readFileSync(path.join(appRoot,file))).digest('hex'),inputs=inputPaths.map(path=>({path,sha256:hash(path)}));
const output=requestedOutput??process.env.NOZELI_TEST_EVIDENCE_ROOT??path.join(import.meta.dirname,'../.test-output/ci/windows-desktop-same-tree-recovery-'+Date.now());
assert(path.isAbsolute(output));assert.equal(process.platform,'win32');fs.mkdirSync(path.dirname(output),{recursive:true});fs.mkdirSync(output);const runs=[];let result;
try{
 for(const [host,command]of [['node',node],['electron',electron]]){
  const env={...process.env};for(const key of Object.keys(env))if(/^(NOZELI_|CCB_|CODEX_|OMP_|PI_|GIT_)/i.test(key)||/AUTH|TOKEN|SECRET|PASSWORD|CREDENTIAL|API_?KEY|ASKPASS/i.test(key)||/^path$/i.test(key)||['NODE_OPTIONS','NODE_PATH','ELECTRON_RUN_AS_NODE'].includes(key))delete env[key];env.Path=path.join(env.SystemRoot??env.SYSTEMROOT,'System32');if(host==='electron')env.ELECTRON_RUN_AS_NODE='1';
  const child=spawnSync(command,['--test','--test-concurrency=2','--test-reporter=tap',...["windows-desktop-same-tree-recovery.test.mjs", "windows-desktop-file-transfer.test.mjs", "windows-desktop-directory-transfer.test.mjs", "windows-desktop-tree-recovery.test.mjs", "windows-desktop-cross-recovery.test.mjs", "storage-recovery-batch.test.mjs"].map(file=>path.join(import.meta.dirname,file))],{cwd:path.resolve(import.meta.dirname,'..'),env,encoding:'utf8',windowsHide:true,timeout:1200000,maxBuffer:4*1024*1024});fs.writeFileSync(path.join(output,host+'.tap'),child.stdout??'');fs.writeFileSync(path.join(output,host+'.err'),child.stderr??'');
 const run={host,command,systemOnlyPath:env.Path,status:child.status,signal:child.signal,pass:Number(child.stdout?.match(/^# pass (\d+)$/m)?.[1]),fail:Number(child.stdout?.match(/^# fail (\d+)$/m)?.[1]),skip:Number(child.stdout?.match(/^# skipped (\d+)$/m)?.[1])};runs.push(run);for(const input of inputs)assert.equal(hash(input.path),input.sha256,'Source changed while '+host+' ran: '+input.path);assert.ifError(child.error);assert.equal(child.status,0,child.stdout+'\n'+child.stderr);assert.equal(child.signal,null);assert.equal(run.pass,93);assert.equal(run.fail,0);assert.equal(run.skip,0);
 }
 result={ok:true,scope:'Windows same-project metadata/draft/create explicit recovery, atomic recovery storage batch, regular/directory native transfer and external/cross-project regression. Original live surface and whole-process same-project recovery remain unqualified',inputs,runs};
}catch(error){result={ok:false,error:error.stack,runs};process.exitCode=1;}
fs.writeFileSync(path.join(output,'report.json'),JSON.stringify(result,null,2));console.log(JSON.stringify(result,null,2));
