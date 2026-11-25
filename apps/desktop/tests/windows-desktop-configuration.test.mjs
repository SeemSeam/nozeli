import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {spawnSync} from 'node:child_process';
import {resolveNozeliPaths,initializeNozeliConfiguration,readNozeliConfiguration,completeNozeliConfiguration} from '../src/agents/managed/nozeli-config.mjs';
import {withWindowsConfigurationLock} from '../src/platform/windows/desktop-configuration.mjs';
import {security} from './fixtures/windows-security.mjs';

const native={skip:process.platform!=='win32'||process.arch!=='x64'};
async function fixture(t){const base=await fs.mkdtemp(path.join(os.tmpdir(),'nozeli-desktop-configuration-'));t.after(()=>fs.rm(base,{recursive:true,force:true}));const paths=resolveNozeliPaths({home:base,env:{}});await initializeNozeliConfiguration(paths);return paths;}
const marker=paths=>path.join(paths.migrations,'setup-v1.json');
function independent(paths,body){
 const source='import fs from "node:fs/promises";import {initializeNozeliConfiguration,readNozeliConfiguration,completeNozeliConfiguration} from '+JSON.stringify(new URL('../src/agents/managed/nozeli-config.mjs',import.meta.url).href)+';import {withWindowsConfigurationLock} from '+JSON.stringify(new URL('../src/platform/windows/desktop-configuration.mjs',import.meta.url).href)+';const paths=JSON.parse(process.argv[1]);'+body;
 const result=spawnSync(process.execPath,['--input-type=module','-e',source,JSON.stringify(paths)],{env:{...process.env},encoding:'utf8',windowsHide:true,timeout:15000});assert.ifError(result.error);assert.equal(result.signal,null);return result;
}
async function staged(paths,extra={}){
 let record;await withWindowsConfigurationLock(paths,async io=>{const stage=path.join(paths.migrations,'import-synthetic-original');const allocated=await io.ensureDirectory(stage);await io.readJson(marker(paths));record={version:1,phase:'staged',choice:'independent',includeApiKeys:false,stage,stageIdentity:allocated.identity,...extra};await io.write(marker(paths),Buffer.from(JSON.stringify(record)));});return record;
}

test('Windows independent setup uses shared staged/completed journal, native private CAS and a real cold process read',native,async t=>{
 const paths=await fixture(t);assert.equal((await readNozeliConfiguration(paths)).initialized,false);
 const result=await completeNozeliConfiguration(paths,{choice:'independent'});assert.equal(result.initialized,true);assert.equal(result.choice,'independent');assert.equal(result.apiKeyImportSupported,false);
 const record=JSON.parse(await fs.readFile(marker(paths),'utf8'));assert.equal(record.phase,'complete');assert.match(record.stageIdentity,/^[a-f0-9]{16}:[a-f0-9]{32}$/);await assert.rejects(fs.lstat(record.stage),{code:'ENOENT'});
 const acl=security('inspect',marker(paths));assert.equal(acl.protected,true);assert.equal(acl.owner,acl.currentSid);assert.equal(acl.rules.length,1);
 const child=independent(paths,'console.log(JSON.stringify(await initializeNozeliConfiguration(paths)));');assert.equal(child.status,0,child.stderr);assert.deepEqual(JSON.parse(child.stdout),result);
 await assert.rejects(completeNozeliConfiguration(paths,{choice:'independent'}),{code:'CONFIG_ALREADY_INITIALIZED'});await assert.rejects(completeNozeliConfiguration(paths,{choice:'import',source:{get agentDir(){throw Error('must not inspect external source');}}}),{code:'CONFIG_IMPORT_UNSUPPORTED'});
});

test('native configuration gate excludes an independent contender and never deletes its persistent identity',native,async t=>{
 const paths=await fixture(t),gate=path.join(paths.migrations,'configuration-native.lock'),before=await fs.stat(gate,{bigint:true});
 await withWindowsConfigurationLock(paths,async()=>{const child=independent(paths,'try{await initializeNozeliConfiguration(paths);process.exitCode=9;}catch(error){console.log(JSON.stringify({code:error.code}));}');assert.equal(child.status,0,child.stderr);assert.equal(JSON.parse(child.stdout).code,'CONFIG_BUSY');});
 await initializeNozeliConfiguration(paths);assert.equal((await fs.stat(gate,{bigint:true})).ino,before.ino);assert(!(await fs.readdir(paths.migrations)).includes('configuration.lock'));
});

test('actual configuration holder process exits without JS cleanup; the same persistent gate is usable after OS handle release',native,async t=>{
 const paths=await fixture(t),gate=path.join(paths.migrations,'configuration-native.lock'),before=await fs.stat(gate,{bigint:true});
 const child=independent(paths,'await withWindowsConfigurationLock(paths,async()=>process.exit(37));');assert.equal(child.status,37,child.stderr);
 assert.equal((await initializeNozeliConfiguration(paths)).initialized,false);assert.equal((await fs.stat(gate,{bigint:true})).ino,before.ino);
});

test('native original staged identity can complete after reopening; replaced same-path stage is retained and refused',native,async t=>{
 const paths=await fixture(t),record=await staged(paths);assert.equal((await completeNozeliConfiguration(paths,{choice:'independent'})).initialized,true);await assert.rejects(fs.lstat(record.stage),{code:'ENOENT'});
 const other=await fixture(t),old=await staged(other);await fs.rename(old.stage,old.stage+'-original');await withWindowsConfigurationLock(other,io=>io.ensureDirectory(old.stage));
 await assert.rejects(completeNozeliConfiguration(other,{choice:'independent'}),{code:'CONFIG_IMPORT_CONFLICT'});assert.equal(JSON.parse(await fs.readFile(marker(other),'utf8')).phase,'staged');assert((await fs.stat(old.stage)).isDirectory());assert((await fs.stat(old.stage+'-original')).isDirectory());
});

test('unexpected stage contents and old markers without original identity remain untouched',native,async t=>{
 const paths=await fixture(t),record=await staged(paths);await fs.writeFile(path.join(record.stage,'config.yml'),'external winner\n');const before=await fs.readFile(marker(paths));
 await assert.rejects(completeNozeliConfiguration(paths,{choice:'independent'}),{code:'CONFIG_IMPORT_UNSAFE'});assert.deepEqual(await fs.readFile(marker(paths)),before);assert.equal(await fs.readFile(path.join(record.stage,'config.yml'),'utf8'),'external winner\n');
 const old=await fixture(t);await staged(old,{stageIdentity:null});await assert.rejects(completeNozeliConfiguration(old,{choice:'independent'}),{code:'CONFIG_RECOVERY_REQUIRED'});
});

test('configuration CAS retains a real independent marker winner rather than refreshing its observed revision',native,async t=>{
 const paths=await fixture(t);await staged(paths);await withWindowsConfigurationLock(paths,async io=>{
  const record=await io.readJson(marker(paths));const child=independent(paths,'await fs.writeFile('+JSON.stringify(marker(paths))+',JSON.stringify({external:"winner"}));');assert.equal(child.status,0,child.stderr);
  await assert.rejects(io.write(marker(paths),Buffer.from(JSON.stringify({...record,phase:'complete'}))),{code:'FS_VERSION_CONFLICT'});
 });assert.deepEqual(JSON.parse(await fs.readFile(marker(paths),'utf8')),{external:'winner'});
});

test('legacy PID locks, unknown gate bytes, damaged JSON and widened ACLs refuse without repair or deletion',native,async t=>{
 const paths=await fixture(t),legacy=path.join(paths.migrations,'configuration.lock');await fs.writeFile(legacy,'{"pid":2147483647,"external":"winner"}');await assert.rejects(initializeNozeliConfiguration(paths),{code:'CONFIG_RECOVERY_REQUIRED'});assert.equal(await fs.readFile(legacy,'utf8'),'{"pid":2147483647,"external":"winner"}');
 const bad=await fixture(t),gate=path.join(bad.migrations,'configuration-native.lock');await fs.writeFile(gate,'external gate winner');await assert.rejects(initializeNozeliConfiguration(bad),{code:'CONFIG_RECOVERY_REQUIRED'});assert.equal(await fs.readFile(gate,'utf8'),'external gate winner');
 const corrupt=await fixture(t);await withWindowsConfigurationLock(corrupt,async io=>{await io.readJson(marker(corrupt));await io.write(marker(corrupt),Buffer.from('{broken'));});await assert.rejects(readNozeliConfiguration(corrupt),SyntaxError);assert.equal(await fs.readFile(marker(corrupt),'utf8'),'{broken');
 const drift=await fixture(t);await completeNozeliConfiguration(drift,{choice:'independent'});security('add-write',marker(drift));const acl=security('inspect',marker(drift)),bytes=await fs.readFile(marker(drift));await assert.rejects(readNozeliConfiguration(drift));assert.deepEqual(await fs.readFile(marker(drift)),bytes);assert.deepEqual(security('inspect',marker(drift)),acl);
});
