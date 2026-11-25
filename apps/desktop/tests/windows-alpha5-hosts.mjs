// Source/extracted Windows hosts. Reports raw child outcomes, including failures.
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {spawnSync} from 'node:child_process';
const require=createRequire(import.meta.url),app=path.resolve(import.meta.dirname,'..');
const [group,output,electron=require('electron'),node=process.execPath,selectedHost='both']=process.argv.slice(2);
const groups={
 shared:['sheet-readiness.test.mjs','windows-closure-retry.test.mjs','windows-recovery-export.test.mjs','storage-recovery-bounded.test.mjs','storage-database-lifetime.test.mjs','collaboration-timing.test.mjs','managed-document-reader.test.mjs','pi-activity.test.mjs','target-model-intent.test.mjs','task-restart-summary.test.mjs','session-execution-presentation.test.mjs','pi-session-admission.test.mjs'],
 native:['windows-native-read.test.mjs','windows-native-write.test.mjs','windows-native-replacement.test.mjs','windows-native-security.test.mjs','windows-native-persistence.test.mjs','windows-native-read-consumer.test.mjs','windows-native-snapshot.test.mjs','windows-native-versioned-write.test.mjs','windows-native-install.test.mjs','windows-native-database.test.mjs','windows-native-directories.test.mjs','windows-native-directory-move.test.mjs','windows-native-private-tree.test.mjs','windows-native-provisioning.test.mjs','windows-native-project-storage.test.mjs','windows-native-material-store.test.mjs','windows-native-work-lifecycle.test.mjs','windows-native-work-changes.test.mjs'],
 process:['windows-process-identity.test.mjs','windows-process-job.test.mjs','windows-process-transport.test.mjs','windows-process-supervisor.test.mjs','windows-supervisor-custody.test.mjs','windows-supervisor-output.test.mjs','windows-supervisor-input.test.mjs','windows-host-sources.test.mjs','windows-workspace-open.test.mjs','windows-owner-launch.test.mjs','windows-host-lease.test.mjs','windows-pi-owner.test.mjs','windows-worker-flow.test.mjs'],
};
assert.equal(process.platform,'win32');assert.equal(process.arch,'x64');assert(path.isAbsolute(output));assert(groups[group]);assert(['both','node','electron'].includes(selectedHost));fs.mkdirSync(output);const runs=[];
for(const [host,command]of [['node',node],['electron',electron]].filter(([host])=>selectedHost==='both'||selectedHost===host)){
 const env={...process.env};for(const key of Object.keys(env))if(/^(NOZELI_|CCB_|CODEX_|OMP_|PI_|GIT_)/i.test(key)||/AUTH|TOKEN|SECRET|PASSWORD|CREDENTIAL|API_?KEY|ASKPASS/i.test(key)||/^path$/i.test(key)||['NODE_OPTIONS','NODE_PATH','ELECTRON_RUN_AS_NODE'].includes(key))delete env[key];
 env.Path=path.join(env.SystemRoot??env.SYSTEMROOT,'System32');env.NOZELI_TEST_PI_ROOT=fs.existsSync(path.join(app,'integrations/pi'))?path.join(app,'integrations/pi'):path.resolve(app,'../../integrations/pi');if(host==='electron')env.ELECTRON_RUN_AS_NODE='1';
 const child=spawnSync(command,['--test','--test-concurrency=2','--test-reporter=tap',...groups[group].map(file=>path.join(import.meta.dirname,file))],{cwd:app,env,windowsHide:true,encoding:'utf8',timeout:600000,maxBuffer:12*1024*1024});fs.writeFileSync(path.join(output,host+'.tap'),child.stdout??'');fs.writeFileSync(path.join(output,host+'.err'),child.stderr??'');
 const count=name=>Number(child.stdout?.match(new RegExp('^# '+name+' (\\d+)$','m'))?.[1]);
 runs.push({host,command,status:child.status,signal:child.signal,error:child.error?.message,tests:count('tests'),pass:count('pass'),fail:count('fail'),skip:count('skipped'),cancelled:count('cancelled'),systemOnlyPath:env.Path});
}
const result={ok:runs.every(run=>run.status===0&&!run.signal&&!run.error&&run.tests>0&&run.pass===run.tests&&run.fail===0&&run.skip===0&&run.cancelled===0),group,files:groups[group],application:app,runs};fs.writeFileSync(path.join(output,'report.json'),JSON.stringify(result,null,2));console.log(JSON.stringify(result,null,2));if(!result.ok)process.exitCode=1;
