import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {spawnSync} from 'node:child_process';
const require=createRequire(import.meta.url);
const [requestedOutput,electron=require('electron'),node=process.execPath]=process.argv.slice(2);
const output=requestedOutput??process.env.NOZELI_TEST_EVIDENCE_ROOT??path.join(import.meta.dirname,'../.test-output/ci/windows-desktop-file-clipboard-'+Date.now());
assert(path.isAbsolute(output));assert.equal(process.platform,'win32');fs.mkdirSync(path.dirname(output),{recursive:true});fs.mkdirSync(output);const runs=[];let result;
try{
 for(const [host,command]of [['node',node],['electron',electron]]){
  const env={...process.env};for(const key of Object.keys(env))if(/^(NOZELI_|CCB_|CODEX_|OMP_|PI_|GIT_)/i.test(key)||/AUTH|TOKEN|SECRET|PASSWORD|CREDENTIAL|API_?KEY|ASKPASS/i.test(key)||/^path$/i.test(key)||['NODE_OPTIONS','NODE_PATH','ELECTRON_RUN_AS_NODE'].includes(key))delete env[key];env.Path=path.join(env.SystemRoot??env.SYSTEMROOT,'System32');if(host==='electron')env.ELECTRON_RUN_AS_NODE='1';
  const child=spawnSync(command,['--test','--test-concurrency=1','--test-reporter=tap',...['windows-desktop-file-clipboard.test.mjs'].map(file=>path.join(import.meta.dirname,file))],{cwd:path.resolve(import.meta.dirname,'..'),env,encoding:'utf8',windowsHide:true,timeout:600000,maxBuffer:4*1024*1024});fs.writeFileSync(path.join(output,host+'.tap'),child.stdout??'');fs.writeFileSync(path.join(output,host+'.err'),child.stderr??'');
  const run={host,command,systemOnlyPath:env.Path,status:child.status,signal:child.signal,pass:Number(child.stdout?.match(/^# pass (\d+)$/m)?.[1]),fail:Number(child.stdout?.match(/^# fail (\d+)$/m)?.[1]),skip:Number(child.stdout?.match(/^# skipped (\d+)$/m)?.[1])};runs.push(run);assert.ifError(child.error);assert.equal(child.status,0,child.stdout+'\n'+child.stderr);assert.equal(child.signal,null);assert.equal(run.pass,17);assert.equal(run.fail,0);assert.equal(run.skip,0);
 }
 result={ok:true,scope:'Windows native clipboard source custody, external exclusive file/directory copy, immutable export snapshots, scoped clipboard/drop tickets, unknown recovery and actual child exits; system recycle bin/full W1-W5 unsupported',runs};
}catch(error){result={ok:false,error:error.stack,runs};process.exitCode=1;}
fs.writeFileSync(path.join(output,'report.json'),JSON.stringify(result,null,2));console.log(JSON.stringify(result,null,2));
