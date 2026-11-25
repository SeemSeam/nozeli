import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {capabilityStatus, implementationCoverage} from '../src/platform/platform-capabilities.mjs';

const probe=fileURLToPath(new URL('../tools/platform-probe.mjs',import.meta.url));
function run(args=[]){
  const result=spawnSync(process.execPath,[probe,...args],{encoding:'utf8',timeout:30000,windowsHide:true});
  assert.ifError(result.error);
  assert.ok([0,1].includes(result.status),result.stderr);
  const report=JSON.parse(result.stdout);
  assert.equal(report.host.platformRaw,process.platform);
  assert.equal(report.host.arch,process.arch);
  return {result,report};
}

test('the native CLI reports unavailable mechanisms without using another platform implementation',()=>{
  const {result,report}=run();
  for(const [capability,name] of [['safe-file-io','safeFileIo'],['verified-process-ownership','processOwnership'],['execution-isolation','executionIsolation']]){
    const status=capabilityStatus(capability).status;
    if(status!=='implemented')assert.equal(report.executedProbes[name].status,status);
  }
  if(!implementationCoverage().complete){assert.equal(report.managedExecution.ready,false);assert.equal(result.status,1);}
  if(process.platform!=='linux')assert.notEqual(report.executedProbes.processOwnership.code,'ENOENT');
});

test('opting out of the isolation probe records not-run and cannot complete missing coverage',()=>{
  const {result,report}=run(['--no-isolation']);
  assert.equal(report.executedProbes.executionIsolation.status,'not-run');
  assert.equal(report.executedProbes.executionIsolation.gating,'not-requested');
  if(!implementationCoverage().complete){assert.equal(report.managedExecution.ready,false);assert.equal(result.status,1);}
});
