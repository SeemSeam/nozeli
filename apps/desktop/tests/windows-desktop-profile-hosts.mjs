import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {spawnSync} from 'node:child_process';
const require=createRequire(import.meta.url);
const [requestedOutput,electron=require('electron'),node=process.execPath]=process.argv.slice(2);
const output=requestedOutput??process.env.NOZELI_TEST_EVIDENCE_ROOT??path.join(import.meta.dirname,'../.test-output/ci/windows-desktop-profile-'+Date.now());
assert(output&&path.isAbsolute(output),'fresh absolute evidence directory required');assert.equal(process.platform,'win32');
fs.mkdirSync(path.dirname(output),{recursive:true});fs.mkdirSync(output);const appRoot=path.resolve(import.meta.dirname,'..'),runs=[];
let result;
try{
 for(const [name,command]of [['node',node],['electron',electron]]){
  const env={...process.env};delete env.NODE_OPTIONS;delete env.NODE_PATH;delete env.ELECTRON_RUN_AS_NODE;if(name==='electron')env.ELECTRON_RUN_AS_NODE='1';
  const child=spawnSync(command,['--test','--test-reporter=tap',path.join(import.meta.dirname,'windows-desktop-profile.test.mjs'),path.join(import.meta.dirname,'windows-desktop-profile-bootstrap.test.mjs')],{cwd:appRoot,env,encoding:'utf8',windowsHide:true,timeout:120000,maxBuffer:4*1024*1024});
  fs.writeFileSync(path.join(output,name+'.tap'),child.stdout??'');fs.writeFileSync(path.join(output,name+'.err'),child.stderr??'');
  const run={host:name,command,status:child.status,signal:child.signal,pass:Number(child.stdout?.match(/^# pass (\d+)$/m)?.[1]),fail:Number(child.stdout?.match(/^# fail (\d+)$/m)?.[1]),skip:Number(child.stdout?.match(/^# skipped (\d+)$/m)?.[1])};runs.push(run);
  assert.ifError(child.error);assert.equal(child.status,0,child.stdout+'\n'+child.stderr);assert.equal(child.signal,null);assert.equal(run.pass,17);assert.equal(run.fail,0);assert.equal(run.skip,0);
 }
 result={ok:true,scope:'desktop profile native records and startup configuration only',runs};
}catch(error){result={ok:false,error:error.stack,runs};process.exitCode=1;}
fs.writeFileSync(path.join(output,'report.json'),JSON.stringify(result,null,2));console.log(JSON.stringify(result,null,2));
