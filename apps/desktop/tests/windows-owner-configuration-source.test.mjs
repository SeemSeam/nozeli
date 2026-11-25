import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {ensureExperimentalPrivateDirectory} from '../src/platform/windows/experimental-directories.mjs';
import {createWindowsDesktopProfileIO} from '../src/platform/windows/desktop-profile.mjs';
import {createOwnerConfigurationSource} from '../src/platform/windows/owner-configuration-source.mjs';
const native={skip:process.platform!=='win32'||process.arch!=='x64'};
test('source rotation preserves owner credential winner and refuses conflicting replacement across synchronizer reopen',native,async t=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'owner-source-'));
 t.after(()=>fs.rm(root,{recursive:true,force:true}));
 const sourceDirectory=path.join(root,'source'),home=path.join(root,'owner'),agentDir=path.join(home,'config');
 await ensureExperimentalPrivateDirectory(root,sourceDirectory);await ensureExperimentalPrivateDirectory(root,agentDir);
 const io=createWindowsDesktopProfileIO(root),source=path.join(sourceDirectory,'auth.json'),target=path.join(agentDir,'auth.json');
 const write=async(file,text)=>io.write(file,Buffer.from(text),{expectedSha256:(await io.read(file)).sha256});
 const reopen=()=>createOwnerConfigurationSource({sourceRoot:root,sourceDirectory,targetRoot:root,home,agentDir});
 await write(source,'{"fixture":{"key":"synthetic-first"}}');await reopen().synchronize();
 await write(source,'{"fixture":{"key":"synthetic-rotated"}}');await reopen().synchronize();
 assert.equal((await io.read(target)).bytes.toString(),'{"fixture":{"key":"synthetic-rotated"}}');
 await write(target,'{"fixture":{"key":"synthetic-owner-winner"}}');await reopen().synchronize();
 assert.equal((await io.read(target)).bytes.toString(),'{"fixture":{"key":"synthetic-owner-winner"}}');
 await write(source,'{"fixture":{"key":"synthetic-contender"}}');await assert.rejects(reopen().synchronize(),{code:'PI_CONFIGURATION_CONFLICT'});
 assert.equal((await io.read(target)).bytes.toString(),'{"fixture":{"key":"synthetic-owner-winner"}}');
 assert.equal((await io.read(source)).bytes.toString(),'{"fixture":{"key":"synthetic-contender"}}');
});

test('first initialization never adopts an existing private credential file',native,async t=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'owner-source-existing-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));
 const sourceDirectory=path.join(root,'source'),home=path.join(root,'owner'),agentDir=path.join(home,'config');
 await ensureExperimentalPrivateDirectory(root,sourceDirectory);await ensureExperimentalPrivateDirectory(root,agentDir);
 const io=createWindowsDesktopProfileIO(root),target=path.join(agentDir,'auth.json'),bytes=Buffer.from('{"fixture":{"key":"synthetic-existing"}}');
 await io.write(target,bytes,{expectedSha256:null});
 const service=createOwnerConfigurationSource({sourceRoot:root,sourceDirectory,targetRoot:root,home,agentDir});
 await assert.rejects(service.synchronize(),{code:'PI_CONFIGURATION_CONFLICT'});
 assert((await io.read(target)).bytes.equals(bytes));
});
