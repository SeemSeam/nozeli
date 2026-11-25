import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {spawnSync} from 'node:child_process';
const require=createRequire(import.meta.url);
const [requestedOutput,electron=require('electron'),node=process.execPath]=process.argv.slice(2);
const output=requestedOutput??process.env.NOZELI_TEST_EVIDENCE_ROOT??path.join(import.meta.dirname,'../.test-output/ci/windows-desktop-update-'+Date.now());
assert(path.isAbsolute(output),'fresh absolute evidence directory required');assert.equal(process.platform,'win32');fs.mkdirSync(path.dirname(output),{recursive:true});fs.mkdirSync(output);
const runs=[];let result;
try{
 for(const [host,command]of [['node',node],['electron',electron]]){
  const env={...process.env};for(const key of Object.keys(env))if(/^path$/i.test(key)||['NODE_OPTIONS','NODE_PATH','ELECTRON_RUN_AS_NODE'].includes(key))delete env[key];env.Path=path.join(env.SystemRoot??env.SYSTEMROOT,'System32');if(host==='electron')env.ELECTRON_RUN_AS_NODE='1';
  const child=spawnSync(command,['--test','--test-concurrency=1','--test-reporter=tap',path.join(import.meta.dirname,'windows-desktop-update.test.mjs'),path.join(import.meta.dirname,'windows-desktop-configuration.test.mjs')],{cwd:path.resolve(import.meta.dirname,'..'),env,encoding:'utf8',windowsHide:true,timeout:120000,maxBuffer:2*1024*1024});fs.writeFileSync(path.join(output,host+'.tap'),child.stdout??'');fs.writeFileSync(path.join(output,host+'.err'),child.stderr??'');
  const run={host,command,systemOnlyPath:env.Path,status:child.status,signal:child.signal,pass:Number(child.stdout?.match(/^# pass (\d+)$/m)?.[1]),fail:Number(child.stdout?.match(/^# fail (\d+)$/m)?.[1]),skip:Number(child.stdout?.match(/^# skipped (\d+)$/m)?.[1])};runs.push(run);assert.ifError(child.error);assert.equal(child.status,0,child.stdout+'\n'+child.stderr);assert.equal(child.signal,null);assert.equal(run.fail,0);assert.equal(run.skip,0);
 }
 result={ok:true,scope:'actual Windows Node/Electron source check-only and forged-update refusal; shared configuration native CAS/stage identity, separate from packaged updater journey qualification',runs};
}catch(error){result={ok:false,error:error.stack,runs};process.exitCode=1;}
fs.writeFileSync(path.join(output,'report.json'),JSON.stringify(result,null,2));console.log(JSON.stringify(result,null,2));
