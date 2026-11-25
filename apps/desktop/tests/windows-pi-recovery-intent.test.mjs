import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {createHash} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {pathToFileURL} from 'node:url';
import {ensureExperimentalPrivateDirectory} from '../src/platform/windows/experimental-directories.mjs';
const runtimeRoot=process.env.NOZELI_TEST_PI_ROOT??path.resolve(import.meta.dirname,'../../../integrations/pi');
const moduleUrl=pathToFileURL(path.join(runtimeRoot,'src/journal-io.mjs')).href;
const {hasRecoveryIntent,publishRecoveryIntent}=await import(moduleUrl);
const native={skip:process.platform!=='win32'||process.arch!=='x64'};
async function fixture(t){
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'nozeli-recovery-intent-')),directory=path.join(root,'private');
 await ensureExperimentalPrivateDirectory(root,directory);
 const bridge=path.resolve(import.meta.dirname,'../native/windows/build/Release/nozeli_windows_read.node');
 const env={NOZELI_PI_PRIVATE_ROOT:root,NOZELI_PI_WINDOWS_NATIVE_BRIDGE:bridge,NOZELI_PI_WINDOWS_NATIVE_SHA256:createHash('sha256').update(await fs.readFile(bridge)).digest('hex')};
 const before={};for(const [key,value] of Object.entries(env)){before[key]=process.env[key];process.env[key]=value;}
 t.after(async()=>{for(const [key,value] of Object.entries(before)){if(value===undefined)delete process.env[key];else process.env[key]=value;}await fs.rm(root,{recursive:true,force:true});});
 return {root,directory,file:path.join(directory,'session.jsonl.recovery-synthetic.json'),env};
}
test('native recovery intent publishes once and an independent process observes the original fence',native,async t=>{
 const f=await fixture(t),value={sessionId:'synthetic',recoveryAttemptId:'original'};
 assert.equal(await hasRecoveryIntent(f.file),false);await publishRecoveryIntent(f.file,value);
 assert.equal(await hasRecoveryIntent(f.file),true);
 await assert.rejects(publishRecoveryIntent(f.file,{...value,recoveryAttemptId:'contender'}),{code:'PI_RECOVERY_RECONCILIATION'});
 assert.deepEqual(JSON.parse(await fs.readFile(f.file,'utf8')),value);
 const script=`const m=await import(${JSON.stringify(moduleUrl)});console.log(JSON.stringify({present:await m.hasRecoveryIntent(process.argv[1])}));`;
 const child=spawnSync(process.execPath,['--input-type=module','-e',script,f.file],{env:{...process.env,...f.env},encoding:'utf8',windowsHide:true,timeout:15000});
 assert.ifError(child.error);assert.equal(child.status,0,child.stderr);assert.deepEqual(JSON.parse(child.stdout),{present:true});
 assert.deepEqual(await fs.readdir(f.directory),[path.basename(f.file)]);
});
test('native recovery barrier failure preserves published fence and refuses another attempt',native,async t=>{
 const f=await fixture(t),value={recoveryAttemptId:'original'};
 await assert.rejects(publishRecoveryIntent(f.file,value,{directorySync(){throw Error('Synthetic directory barrier failure after actual publication');}}),{code:'PI_PERSISTENCE_UNCONFIRMED',committed:true,automaticReplay:false});
 assert.equal(await hasRecoveryIntent(f.file),true);assert.deepEqual(JSON.parse(await fs.readFile(f.file,'utf8')),value);
 await assert.rejects(publishRecoveryIntent(f.file,{recoveryAttemptId:'retry'}),{code:'PI_RECOVERY_RECONCILIATION'});
 assert.deepEqual(JSON.parse(await fs.readFile(f.file,'utf8')),value);
});
test('native recovery intent refuses redirected ancestry and out-of-root destinations before publication',native,async t=>{
 const f=await fixture(t),outside=path.join(f.root,'outside');await fs.mkdir(outside);await fs.symlink(outside,path.join(f.directory,'junction'),'junction');
 await assert.rejects(publishRecoveryIntent(path.join(f.directory,'junction','fence.json'),{}));
 await assert.rejects(hasRecoveryIntent(path.join(f.directory,'junction','fence.json')));
 await assert.rejects(publishRecoveryIntent(path.join(f.root,'..','forbidden-fence.json'),{}),{code:'PI_JOURNAL_UNVERIFIED'});
 assert.deepEqual(await fs.readdir(outside),[]);
});
