import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {AutoUpdater} from '../src/main/auto-update.mjs';
import {ensureExperimentalPrivateDirectory} from '../src/platform/windows/experimental-directories.mjs';
import {acquireInstallLock,acknowledgeUpdateHealth} from '../src/main/auto-update-helper.mjs';

const windows={skip:process.platform!=='win32'||process.arch!=='x64'};
async function fixture(t){const root=await fs.mkdtemp(path.join(os.tmpdir(),'nozeli-windows-update-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));await ensureExperimentalPrivateDirectory(root,path.join(root,'private'));return root;}
function release(){return {tag_name:'v1.0.1',assets:[{name:'Nozeli-1.0.1-windows-x64.zip',size:100,browser_download_url:'https://github.com/SeemSeam/nozeli/releases/download/v1.0.1/package.zip'},{name:'SHA256SUMS.txt',size:100,browser_download_url:'https://github.com/SeemSeam/nozeli/releases/download/v1.0.1/SHA256SUMS.txt'}]};}
test('Windows source checkout checks its ZIP channel but cannot download or activate an unowned installation',windows,async t=>{
 const root=await fixture(t),requests=[];
 const updater=new AutoUpdater({currentVersion:'1.0.0',appRoot:root,stateDir:path.join(root,'private','updates'),enabled:false,dependencies:{fetch:async url=>{requests.push(url);return new Response(JSON.stringify([release()]));}},quit:()=>{throw Error('unowned source cannot quit to update')},spawn:()=>{throw Error('unowned source cannot launch helper')}});
 await updater.start();assert.equal(requests.length,0);
 const result=await updater.check();assert.equal(result.checksSupported,true);assert.equal(result.supported,false);assert.equal(result.availableVersion,'1.0.1');assert.equal(result.phase,'unsupported');assert.equal(requests.length,1);
 updater.stop();await updater.persist;
 assert.equal((await fs.readdir(path.join(root,'private','updates'))).some(name=>name.startsWith('download-')),false);
});
test('forged Windows health evidence cannot acknowledge an unowned payload or use the POSIX installer lock',windows,async t=>{
 const root=await fixture(t),token='a'.repeat(64),receipt=path.join(root,'private','health-'+token+'.json');
 await assert.rejects(acknowledgeUpdateHealth({appRoot:root,env:{NOZELI_UPDATE_RECEIPT:receipt,NOZELI_UPDATE_TOKEN:token}}));
 await assert.rejects(fs.stat(receipt),{code:'ENOENT'});
 await assert.rejects(acquireInstallLock(root,token),{code:'UPDATE_NATIVE_HANDOFF_REQUIRED'});
 await assert.rejects(fs.stat(path.join(root,'.installer-lock')),{code:'ENOENT'});
});
