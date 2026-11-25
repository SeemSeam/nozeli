// Fixed qualification entry: pure lifetime/metadata tests in both hosts, then
// actual GUI processes. The GUI harness accepts package/peer paths explicitly.
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {spawnSync} from 'node:child_process';
const require=createRequire(import.meta.url);
const [requestedOutput,electron=require('electron'),node=process.execPath,application,requestedGuiHarness]=process.argv.slice(2);
// Qualification drivers use development dependencies; those are deliberately
// absent from the product closure. An extracted run names its external driver.
const guiHarness=requestedGuiHarness??path.join(import.meta.dirname,'windows-desktop-singleton.mjs');
assert(path.isAbsolute(guiHarness));assert(fs.statSync(guiHarness).isFile());
const output=requestedOutput??process.env.NOZELI_TEST_EVIDENCE_ROOT??path.join(import.meta.dirname,'../.test-output/ci/windows-desktop-singleton-'+Date.now());
assert(path.isAbsolute(output));assert.equal(process.platform,'win32');fs.mkdirSync(path.dirname(output),{recursive:true});fs.mkdirSync(output);
const runs=[];let result;
try{
 for(const [host,command]of [['node',node],['electron',electron]]){
  const env={...process.env};for(const key of Object.keys(env))if(/^path$/i.test(key)||['NODE_OPTIONS','NODE_PATH','ELECTRON_RUN_AS_NODE'].includes(key))delete env[key];env.Path=path.join(env.SystemRoot??env.SYSTEMROOT,'System32');if(host==='electron')env.ELECTRON_RUN_AS_NODE='1';
  const child=spawnSync(command,['--test','--test-reporter=tap','--test-concurrency=1',path.join(import.meta.dirname,'application-singleton.test.mjs')],{env,encoding:'utf8',windowsHide:true,timeout:30000});fs.writeFileSync(path.join(output,host+'.tap'),child.stdout??'');fs.writeFileSync(path.join(output,host+'.err'),child.stderr??'');
  const run={host,command,status:child.status,signal:child.signal,pass:Number(child.stdout?.match(/^# pass (\d+)$/m)?.[1]),fail:Number(child.stdout?.match(/^# fail (\d+)$/m)?.[1]),skip:Number(child.stdout?.match(/^# skipped (\d+)$/m)?.[1])};runs.push(run);assert.ifError(child.error);assert.equal(child.status,0,child.stdout+'\n'+child.stderr);assert.equal(run.pass,3);assert.equal(run.fail,0);assert.equal(run.skip,0);
 }
 const child=spawnSync(node,[guiHarness,path.join(output,'gui'),...(application?[application,electron]:[])],{env:{...process.env,ELECTRON_RUN_AS_NODE:undefined},encoding:'utf8',windowsHide:true,timeout:180000,maxBuffer:4*1024*1024});fs.writeFileSync(path.join(output,'gui.log'),(child.stdout??'')+(child.stderr??''));assert.ifError(child.error);assert.equal(child.status,0,child.stdout+'\n'+child.stderr);assert.equal(child.signal,null);
 result={ok:true,runs,guiHarness,gui:JSON.parse(fs.readFileSync(path.join(output,'gui/report.json'),'utf8'))};
}catch(error){result={ok:false,error:error.stack,runs};process.exitCode=1;}
fs.writeFileSync(path.join(output,'report.json'),JSON.stringify(result,null,2));console.log(JSON.stringify({ok:result.ok,runs,error:result.error,output},null,2));
